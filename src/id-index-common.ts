import type * as Lark from "@larksuiteoapi/node-sdk";

export type FeishuResolvedIdType = "open_id" | "user_id" | "union_id" | "chat_id";

const MAX_LOOKUP_EMAILS = 50;
const MAX_LOOKUP_MOBILES = 50;

export const KNOWN_FEISHU_ID_ERRORS: Record<number, string> = {
  99992361:
    "open_id is app-scoped — this open_id belongs to a different app. Check accountId.",
  41050:
    "User not in app's contact scope. Adjust contact permissions in Feishu developer console.",
  99992364:
    "user_id cross-tenant — this user_id belongs to a different tenant. Use union_id or open_id instead.",
  232010: "Cross-tenant error — bot and target are in different tenants.",
  232011: "Bot is not a member of this chat. Add the bot to the chat first.",
  232025:
    "Bot capability not enabled. Enable it in Feishu developer console.",
};

export function detectIdType(id: string): FeishuResolvedIdType | null {
  const trimmed = id.trim();
  if (trimmed.startsWith("oc_")) return "chat_id";
  if (trimmed.startsWith("ou_")) return "open_id";
  if (trimmed.startsWith("on_")) return "union_id";
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return "user_id";
  return null;
}

export function formatApiError(code: number, msg?: string): string {
  const hint = KNOWN_FEISHU_ID_ERRORS[code];
  const base = msg || `API error ${code}`;
  return hint ? `${base} [hint: ${hint}]` : base;
}

export function extractFeishuError(err: unknown): { code: number; msg: string } | null {
  if (!err || typeof err !== "object") return null;
  const axiosErr = err as { response?: { data?: { code?: number; msg?: string } } };
  const data = axiosErr.response?.data;
  if (data && typeof data.code === "number") {
    return { code: data.code, msg: data.msg ?? "" };
  }
  return null;
}

export function throwFeishuError(err: unknown): never {
  const feishuErr = extractFeishuError(err);
  if (feishuErr) {
    throw new Error(formatApiError(feishuErr.code, feishuErr.msg));
  }
  throw err;
}

function validateLookupBatchSize(emails?: string[], mobiles?: string[]) {
  if ((emails?.length ?? 0) > MAX_LOOKUP_EMAILS) {
    throw new Error(`lookup supports at most ${MAX_LOOKUP_EMAILS} emails per call`);
  }
  if ((mobiles?.length ?? 0) > MAX_LOOKUP_MOBILES) {
    throw new Error(`lookup supports at most ${MAX_LOOKUP_MOBILES} mobiles per call`);
  }
}

export async function resolveId(
  client: Lark.Client,
  id: string,
  idType: FeishuResolvedIdType,
) {
  try {
    if (idType === "chat_id") {
      const res = await client.im.chat.get({ path: { chat_id: id } });
      if (res.code !== 0) throw new Error(formatApiError(res.code!, res.msg));
      const chat = res.data;
      return {
        chat_id: id,
        name: chat?.name,
        owner_id: chat?.owner_id,
        user_count: chat?.user_count,
        chat_type: chat?.chat_type,
        chat_mode: chat?.chat_mode,
        tenant_key: chat?.tenant_key,
      };
    }

    const res = await client.contact.user.get({
      path: { user_id: id },
      params: { user_id_type: idType as any },
    });
    if (res.code !== 0) throw new Error(formatApiError(res.code!, res.msg));
    const user = res.data?.user;
    return {
      open_id: user?.open_id,
      union_id: user?.union_id,
      user_id: user?.user_id,
      name: user?.name,
      input_id: id,
      input_id_type: idType,
    };
  } catch (err) {
    throwFeishuError(err);
  }
}

export async function lookupByContact(
  client: Lark.Client,
  emails?: string[],
  mobiles?: string[],
  includeResigned?: boolean,
) {
  validateLookupBatchSize(emails, mobiles);

  try {
    const batchRes = await client.contact.user.batchGetId({
      params: { user_id_type: "open_id" },
      data: {
        emails: emails ?? [],
        mobiles: mobiles ?? [],
        include_resigned: includeResigned,
      },
    });
    if (batchRes.code !== 0) {
      throw new Error(formatApiError(batchRes.code!, batchRes.msg));
    }

    const userList = batchRes.data?.user_list ?? [];
    const notFound: string[] = [];
    const foundEntries: Array<{
      email?: string;
      mobile?: string;
      openId: string;
    }> = [];

    for (const item of userList) {
      if (item.user_id) {
        foundEntries.push({
          email: item.email,
          mobile: item.mobile,
          openId: item.user_id,
        });
      }
    }

    for (const email of emails ?? []) {
      if (!userList.some((user) => user.email === email && user.user_id)) {
        notFound.push(email);
      }
    }
    for (const mobile of mobiles ?? []) {
      if (!userList.some((user) => user.mobile === mobile && user.user_id)) {
        notFound.push(mobile);
      }
    }

    const results: Array<Record<string, unknown>> = [];
    if (foundEntries.length > 0) {
      const openIds = foundEntries.map((entry) => entry.openId);
      const inputByOpenId = new Map(foundEntries.map((entry) => [entry.openId, entry]));
      try {
        const batchUserRes = await client.contact.user.batch({
          params: { user_id_type: "open_id", user_ids: openIds },
        });
        if (batchUserRes.code === 0 && batchUserRes.data?.items) {
          for (const user of batchUserRes.data.items) {
            const entry = user.open_id ? inputByOpenId.get(user.open_id) : undefined;
            results.push({
              email: entry?.email,
              mobile: entry?.mobile,
              open_id: user.open_id,
              union_id: user.union_id,
              user_id: user.user_id,
              name: user.name,
            });
          }
        }
      } catch (enrichErr) {
        const errDetail = extractFeishuError(enrichErr);
        const enrichmentError = errDetail
          ? formatApiError(errDetail.code, errDetail.msg)
          : (enrichErr instanceof Error ? enrichErr.message : String(enrichErr));
        for (const entry of foundEntries) {
          results.push({
            email: entry.email,
            mobile: entry.mobile,
            open_id: entry.openId,
            _enrichment_error: enrichmentError,
          });
        }
      }
    }

    return {
      results,
      not_found: notFound,
    };
  } catch (err) {
    throwFeishuError(err);
  }
}

export async function whois(
  client: Lark.Client,
  id: string,
  idType: Exclude<FeishuResolvedIdType, "chat_id">,
) {
  try {
    const res = await client.contact.user.get({
      path: { user_id: id },
      params: { user_id_type: idType as any },
    });
    if (res.code !== 0) throw new Error(formatApiError(res.code!, res.msg));
    const user = res.data?.user;
    return {
      open_id: user?.open_id,
      union_id: user?.union_id,
      user_id: user?.user_id,
      name: user?.name,
      en_name: user?.en_name,
      avatar: user?.avatar,
      department_ids: user?.department_ids,
      job_title: user?.job_title,
      mobile: user?.mobile,
      email: user?.email,
      status: user?.status,
    };
  } catch (err) {
    throwFeishuError(err);
  }
}

export async function getEnrichedMembers(
  client: Lark.Client,
  chatId: string,
  pageSize?: number,
  pageToken?: string,
) {
  try {
    const res = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: {
        page_size: Math.min(Math.max(pageSize ?? 50, 1), 100),
        page_token: pageToken,
        member_id_type: "open_id",
      },
    });
    if (res.code !== 0) throw new Error(formatApiError(res.code!, res.msg));

    const items = res.data?.items ?? [];
    const openIds = items.map((member) => member.member_id).filter(Boolean) as string[];
    const enriched: Record<string, { union_id?: string; user_id?: string; name?: string }> = {};
    let enrichmentError: string | undefined;

    if (openIds.length > 0) {
      try {
        const batchRes = await client.contact.user.batch({
          params: { user_id_type: "open_id", user_ids: openIds },
        });
        if (batchRes.code === 0 && batchRes.data?.items) {
          for (const user of batchRes.data.items) {
            if (user.open_id) {
              enriched[user.open_id] = {
                union_id: user.union_id,
                user_id: user.user_id,
                name: user.name,
              };
            }
          }
        }
      } catch (enrichErr) {
        const errDetail = extractFeishuError(enrichErr);
        enrichmentError = errDetail
          ? formatApiError(errDetail.code, errDetail.msg)
          : (enrichErr instanceof Error ? enrichErr.message : String(enrichErr));
      }
    }

    const result: Record<string, unknown> = {
      chat_id: chatId,
      member_total: (res.data as any)?.member_total,
      members: items.map((member) => ({
        open_id: member.member_id,
        union_id: enriched[member.member_id!]?.union_id,
        user_id: enriched[member.member_id!]?.user_id,
        name: member.name ?? enriched[member.member_id!]?.name,
        tenant_key: member.tenant_key,
      })),
      has_more: res.data?.has_more ?? false,
      page_token: res.data?.page_token ?? null,
    };
    if (enrichmentError) {
      result._enrichment_error = enrichmentError;
    }
    return result;
  } catch (err) {
    throwFeishuError(err);
  }
}

export async function listMyChats(
  client: Lark.Client,
  pageSize?: number,
  pageToken?: string,
) {
  try {
    const res = await client.im.chat.list({
      params: {
        page_size: Math.min(Math.max(pageSize ?? 20, 1), 100),
        page_token: pageToken,
        sort_type: "ByActiveTimeDesc",
      },
    });
    if (res.code !== 0) throw new Error(formatApiError(res.code!, res.msg));
    return {
      chats:
        res.data?.items?.map((chat) => ({
          chat_id: chat.chat_id,
          name: chat.name,
          description: chat.description,
          owner_id: chat.owner_id,
          tenant_key: chat.tenant_key,
        })) ?? [],
      has_more: res.data?.has_more ?? false,
      page_token: res.data?.page_token ?? null,
    };
  } catch (err) {
    throwFeishuError(err);
  }
}

export async function searchChats(
  client: Lark.Client,
  query: string,
  pageSize?: number,
  pageToken?: string,
) {
  try {
    const res = await client.im.chat.search({
      params: {
        query,
        page_size: Math.min(Math.max(pageSize ?? 20, 1), 100),
        page_token: pageToken,
      },
    });
    if (res.code !== 0) throw new Error(formatApiError(res.code!, res.msg));
    return {
      chats:
        res.data?.items?.map((chat) => ({
          chat_id: chat.chat_id,
          name: chat.name,
          description: chat.description,
          owner_id: chat.owner_id,
          tenant_key: chat.tenant_key,
        })) ?? [],
      has_more: res.data?.has_more ?? false,
      page_token: res.data?.page_token ?? null,
    };
  } catch (err) {
    throwFeishuError(err);
  }
}
