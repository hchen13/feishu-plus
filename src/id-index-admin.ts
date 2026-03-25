import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listFeishuAccountIds, resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { FeishuIdAdminSchema, type FeishuIdAdminParams } from "./id-index-admin-schema.js";
import {
  buildObservedCanonicalProfile,
  buildObservedIndex,
  deriveGroupSeeds,
  findObservedUsers,
  getObservedIndexPath,
  loadObservedIndex,
  searchObserved,
  type ObservedIndex,
} from "./id-index-observed.js";
import {
  getEnrichedMembers,
  resolveId,
  type FeishuResolvedIdType,
} from "./id-index-common.js";
import { resolveToolsConfig } from "./tools-config.js";
import {
  hasFeishuToolEnabledForAnyAccount,
  makeFeishuToolFactory,
  resolveToolAccount,
} from "./tools-common/tool-exec.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function normalizeAccountIds(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function checkSupervisorPermission(params: {
  cfg: OpenClawPluginApi["config"];
  callingAccountId: string;
  targetAccountId: string;
}) {
  const { cfg, callingAccountId, targetAccountId } = params;
  if (callingAccountId === targetAccountId) return;
  const targetAccount = resolveFeishuAccount({ cfg, accountId: targetAccountId });
  const supervisors: string[] = (targetAccount.config as any).allowedSupervisors ?? [];
  const allowed = supervisors.some((entry) => entry === "*" || entry === callingAccountId);
  if (!allowed) {
    throw new Error(
      `Feishu: account "${callingAccountId}" is not authorized to operate as "${targetAccountId}". ` +
        `Add "${callingAccountId}" to channels.feishu.accounts.${targetAccountId}.allowedSupervisors to grant access.`,
    );
  }
}

function resolveAdminAccounts(params: {
  api: OpenClawPluginApi;
  agentAccountId?: string;
  agentId?: string;
  asAccountId?: string;
  requestedAccountIds?: string[];
}) {
  if (!params.api.config) {
    throw new Error("Feishu config is not available");
  }

  const cfg = params.api.config;
  const configuredAccountIds = new Set(listFeishuAccountIds(cfg));
  const callingAccount = resolveToolAccount(
    cfg,
    params.agentAccountId,
    params.agentId,
    params.asAccountId,
  );

  let effectiveAccount = callingAccount;
  if (params.asAccountId && params.asAccountId !== callingAccount.accountId) {
    if (!configuredAccountIds.has(params.asAccountId)) {
      throw new Error(`Unknown Feishu account "${params.asAccountId}"`);
    }
    checkSupervisorPermission({
      cfg,
      callingAccountId: callingAccount.accountId,
      targetAccountId: params.asAccountId,
    });
    effectiveAccount = resolveFeishuAccount({ cfg, accountId: params.asAccountId });
  }

  const requested = normalizeAccountIds(params.requestedAccountIds);
  const accountIds = requested.length ? requested : [effectiveAccount.accountId];
  const accounts = accountIds.map((accountId) => {
    if (!configuredAccountIds.has(accountId)) {
      throw new Error(`Unknown Feishu account "${accountId}"`);
    }
    checkSupervisorPermission({
      cfg,
      callingAccountId: callingAccount.accountId,
      targetAccountId: accountId,
    });
    const account = resolveFeishuAccount({ cfg, accountId });
    if (!account.enabled) {
      throw new Error(`Feishu account "${account.accountId}" is disabled`);
    }
    if (!account.configured) {
      throw new Error(`Feishu account "${account.accountId}" is not configured`);
    }
    if (!resolveToolsConfig(account.config.tools).id) {
      throw new Error(`Feishu tool "id" is disabled for account "${account.accountId}"`);
    }
    return account;
  });

  return {
    callingAccount,
    effectiveAccount,
    accounts,
  };
}

async function tryResolveUser(client: Lark.Client, id: string, idType: FeishuResolvedIdType) {
  if (idType === "chat_id") return null;
  const resolved = await resolveId(client, id, idType);
  return {
    open_id: resolved.open_id ?? null,
    union_id: resolved.union_id ?? null,
    user_id: resolved.user_id ?? null,
    name: resolved.name ?? null,
  };
}

async function verifyViaGroupMembership(params: {
  client: Lark.Client;
  accountId: string;
  query: string;
  aliases: string[];
  candidateOpenId?: string;
  groupSeeds: Array<{ accountId: string; chatId: string; chatNames: string[] }>;
  attempts: Array<Record<string, unknown>>;
}) {
  const loweredAliases = [params.query, ...params.aliases]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  for (const seed of params.groupSeeds) {
    if (seed.accountId !== params.accountId) continue;
    try {
      const members = await getEnrichedMembers(params.client, seed.chatId);
      const rows = Array.isArray((members as Record<string, unknown>).members)
        ? ((members as Record<string, unknown>).members as Array<Record<string, unknown>>)
        : [];
      const hit = rows.find((row) => {
        const openId = typeof row.open_id === "string" ? row.open_id : null;
        const name = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
        if (params.candidateOpenId && openId === params.candidateOpenId) return true;
        return loweredAliases.some((alias) => alias && alias === name);
      });

      if (hit) {
        const result = {
          open_id: (hit.open_id as string | undefined) ?? null,
          union_id: (hit.union_id as string | undefined) ?? null,
          user_id: (hit.user_id as string | undefined) ?? null,
          name: (hit.name as string | undefined) ?? null,
          tenant_key: (hit.tenant_key as string | undefined) ?? null,
          chat_id: seed.chatId,
          chat_names: seed.chatNames,
        };
        params.attempts.push({
          ok: true,
          route: "chat-members",
          idType: "chat_id",
          id: seed.chatId,
          result,
        });
        return {
          accessible: true,
          resolved_via: "chat-members",
          result,
        };
      }

      params.attempts.push({
        ok: false,
        route: "chat-members",
        idType: "chat_id",
        id: seed.chatId,
        error: {
          message: "target not found in chat members",
          code: null,
          statusCode: null,
        },
      });
    } catch (error) {
      params.attempts.push({
        ok: false,
        route: "chat-members",
        idType: "chat_id",
        id: seed.chatId,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: number } | null)?.code ?? null,
          statusCode: (error as { statusCode?: number } | null)?.statusCode ?? null,
        },
      });
    }
  }

  return null;
}

async function verifyForAccount(params: {
  client: Lark.Client;
  accountId: string;
  target: {
    query: string;
    aliases: string[];
    open_ids_by_account: Record<string, string>;
    union_ids: string[];
    user_ids: string[];
    group_seeds: Array<{ accountId: string; chatId: string; chatNames: string[] }>;
  };
  exhaustive: boolean;
}) {
  const attempts: Array<Record<string, unknown>> = [];
  const candidates: Array<{ route: string; idType: FeishuResolvedIdType; id: string }> = [];
  const seen = new Set<string>();

  const sameAccountOpenId = params.target.open_ids_by_account[params.accountId];
  if (sameAccountOpenId) {
    candidates.push({
      route: "same-account-open-id",
      idType: "open_id",
      id: sameAccountOpenId,
    });
  }
  for (const unionId of params.target.union_ids) {
    candidates.push({
      route: "union-id-bridge",
      idType: "union_id",
      id: unionId,
    });
  }
  for (const userId of params.target.user_ids) {
    candidates.push({
      route: "tenant-user-id",
      idType: "user_id",
      id: userId,
    });
  }

  let firstSuccess: { resolved_via: string; result: Record<string, unknown> } | null = null;

  for (const candidate of candidates) {
    const key = `${candidate.idType}|${candidate.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const result = await tryResolveUser(params.client, candidate.id, candidate.idType);
      if (!result) continue;
      attempts.push({
        ok: true,
        route: candidate.route,
        idType: candidate.idType,
        id: candidate.id,
        result,
      });
      if (!firstSuccess) {
        firstSuccess = {
          resolved_via: candidate.route,
          result,
        };
      }
      if (!params.exhaustive) {
        return {
          account_id: params.accountId,
          accessible: true,
          resolved_via: candidate.route,
          attempts,
          result,
        };
      }
    } catch (error) {
      attempts.push({
        ok: false,
        route: candidate.route,
        idType: candidate.idType,
        id: candidate.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: number } | null)?.code ?? null,
          statusCode: (error as { statusCode?: number } | null)?.statusCode ?? null,
        },
      });
    }
  }

  const groupHit = await verifyViaGroupMembership({
    client: params.client,
    accountId: params.accountId,
    query: params.target.query,
    aliases: params.target.aliases,
    candidateOpenId: sameAccountOpenId,
    groupSeeds: params.target.group_seeds,
    attempts,
  });
  if (groupHit && !firstSuccess) {
    firstSuccess = {
      resolved_via: groupHit.resolved_via,
      result: groupHit.result,
    };
  }

  if (groupHit && !params.exhaustive) {
    return {
      account_id: params.accountId,
      accessible: true,
      resolved_via: groupHit.resolved_via,
      attempts,
      result: groupHit.result,
    };
  }

  if (firstSuccess) {
    return {
      account_id: params.accountId,
      accessible: true,
      resolved_via: firstSuccess.resolved_via,
      attempts,
      result: firstSuccess.result,
    };
  }

  return {
    account_id: params.accountId,
    accessible: false,
    resolved_via: null,
    attempts,
    result: null,
  };
}

function makeTarget(index: ObservedIndex, query: string) {
  const matches = findObservedUsers(index, query);
  const groupSeeds = deriveGroupSeeds(index, matches);
  const canonical = buildObservedCanonicalProfile(query, matches, groupSeeds);
  return {
    query,
    observed_matches: matches,
    canonical,
  };
}

async function verifyQueries(params: {
  api: OpenClawPluginApi;
  agentAccountId?: string;
  agentId?: string;
  queries: string[];
  requestedAccountIds?: string[];
  asAccountId?: string;
  refreshIndex?: boolean;
  exhaustive?: boolean;
}) {
  const scope = resolveAdminAccounts({
    api: params.api,
    agentAccountId: params.agentAccountId,
    agentId: params.agentId,
    asAccountId: params.asAccountId,
    requestedAccountIds: params.requestedAccountIds,
  });
  const index = await loadObservedIndex(params.refreshIndex);
  const targets = params.queries.map((query) => makeTarget(index, query));
  const accountClients = new Map(
    scope.accounts.map((account) => [account.accountId, createFeishuClient(account)]),
  );

  const results = [];
  for (const target of targets) {
    const accountResults = [];
    for (const account of scope.accounts) {
      const client = accountClients.get(account.accountId)!;
      accountResults.push(
        await verifyForAccount({
          client,
          accountId: account.accountId,
          target: {
            query: target.query,
            aliases: target.canonical.aliases,
            open_ids_by_account: target.canonical.open_ids_by_account,
            union_ids: target.canonical.union_ids,
            user_ids: target.canonical.user_ids,
            group_seeds: target.canonical.group_seeds,
          },
          exhaustive: params.exhaustive ?? false,
        }),
      );
    }
    results.push({
      query: target.query,
      observed_matches: target.observed_matches,
      canonical: target.canonical,
      account_results: accountResults,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    observed_index_path: getObservedIndexPath(),
    observed_index_generated_at: index.generatedAt,
    exhaustive: params.exhaustive ?? false,
    _callingAccountId: scope.callingAccount.accountId,
    _effectiveAccountId: scope.effectiveAccount.accountId,
    accounts: scope.accounts.map((account) => account.accountId),
    targets: results,
  };
}

const TOOL_DESCRIPTION = `Feishu ID Admin — rebuild local observations and diagnose cross-account visibility.

Actions:
- rebuild_index: scan local OpenClaw Feishu sessions and rebuild the observed identity index
- search_observed: search the local observed index by name, alias, or ID fragment
- verify_matrix: explain which Feishu accounts can resolve one or more observed people
- explain_visibility: single-target version of verify_matrix with full attempt traces`;

export function registerFeishuIdAdminTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_id_admin: No config available, skipping");
    return;
  }

  if (!hasFeishuToolEnabledForAnyAccount(api.config, "id")) {
    api.logger.debug?.("feishu_id_admin: id tool disabled or no accounts configured");
    return;
  }

  api.registerTool(
    makeFeishuToolFactory((agentAccountId, agentId) => ({
      name: "feishu_id_admin",
      label: "Feishu ID Admin",
      description: TOOL_DESCRIPTION,
      parameters: FeishuIdAdminSchema,
      async execute(_toolCallId, params) {
        const parsed = params as FeishuIdAdminParams;
        const requestedAccountIds = normalizeAccountIds(parsed.account_ids);
        switch (parsed.action) {
          case "rebuild_index": {
            const rebuilt = await buildObservedIndex();
            return json({
              action: "rebuild_index",
              observed_index_path: getObservedIndexPath(),
              generated_at: rebuilt.generatedAt,
              counts: rebuilt.counts,
              source_roots: rebuilt.sourceRoots,
            });
          }

          case "search_observed": {
            if (!parsed.query?.trim()) {
              return json({ error: "search_observed requires 'query'" });
            }
            if (requestedAccountIds.length > 1) {
              return json({
                error: "search_observed accepts at most one account_id filter",
              });
            }
            const scope = resolveAdminAccounts({
              api,
              agentAccountId,
              agentId,
              asAccountId: parsed.asAccountId,
              requestedAccountIds: requestedAccountIds.length ? [requestedAccountIds[0]!] : undefined,
            });
            const index = await loadObservedIndex(parsed.refresh_index);
            return json({
              ...searchObserved(
                index,
                parsed.query,
                scope.accounts[0]?.accountId,
                parsed.limit && Number.isFinite(parsed.limit) ? Math.max(1, Math.floor(parsed.limit)) : 20,
              ),
              _callingAccountId: scope.callingAccount.accountId,
              _effectiveAccountId: scope.effectiveAccount.accountId,
            });
          }

          case "verify_matrix": {
            const queries = [...new Set((parsed.queries ?? []).map((query) => query.trim()).filter(Boolean))];
            if (queries.length === 0) {
              return json({ error: "verify_matrix requires non-empty 'queries'" });
            }
            return json(
              await verifyQueries({
                api,
                agentAccountId,
                agentId,
                queries,
                requestedAccountIds,
                asAccountId: parsed.asAccountId,
                refreshIndex: parsed.refresh_index,
                exhaustive: parsed.exhaustive,
              }),
            );
          }

          case "explain_visibility": {
            if (!parsed.query?.trim()) {
              return json({ error: "explain_visibility requires 'query'" });
            }
            const report = await verifyQueries({
              api,
              agentAccountId,
              agentId,
              queries: [parsed.query],
              requestedAccountIds,
              asAccountId: parsed.asAccountId,
              refreshIndex: parsed.refresh_index,
              exhaustive: parsed.exhaustive ?? true,
            });
            return json({
              ...report,
              target: report.targets[0] ?? null,
            });
          }

          default:
            return json({ error: `Unknown action: ${String(parsed.action)}` });
        }
      },
    })),
    { name: "feishu_id_admin" },
  );

  api.logger.info?.("feishu_id_admin: Registered feishu_id_admin tool");
}
