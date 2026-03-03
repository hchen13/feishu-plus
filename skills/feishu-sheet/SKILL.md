---
name: feishu-sheet
description: |
  Feishu spreadsheet read/write operations. Activate when user mentions Sheets links, ranges, or cell edits.
---

# Feishu Sheet Tool

Single tool `feishu_sheet` with `action` for spreadsheet operations.

## Token Extraction

Supported URL formats:
- `https://xxx.feishu.cn/sheets/ABC123` → `spreadsheet_token=ABC123`
- `https://xxx.feishu.cn/sheet/ABC123` → `spreadsheet_token=ABC123`
- `https://xxx.feishu.cn/wiki/ABC123` → auto-resolve wiki node to spreadsheet token

Optional query/hash parsing:
- `?sheet=shtxxxx` → `sheet_id=shtxxxx`
- `?range=A1:C10` → `range=A1:C10`

## Actions Overview

| Action | Purpose |
|---|---|
| `get_meta` | List sheets + metadata |
| `read_range` | Read cell values |
| `write_range` | Overwrite cells |
| `append_rows` | Append rows to end of data |
| `set_format` | Apply numeric format string |
| `set_style` | Apply cell visual style |
| `insert_image` | Insert floating image anchored to a cell |
| `insert_cell_image` | Embed image inside a cell |

---

## Actions

### 1) Get Spreadsheet Meta

```json
{ "action": "get_meta", "url": "https://xxx.feishu.cn/sheets/shtcnxxxx" }
```

Or direct token:

```json
{ "action": "get_meta", "spreadsheet_token": "shtcnxxxx" }
```

Returns spreadsheet info + worksheet list (`sheet_id`, title, row/column count).

---

### 2) Read Range

```json
{
  "action": "read_range",
  "spreadsheet_token": "shtcnxxxx",
  "sheet_id": "e7bea9",
  "range": "A1:C5"
}
```

Full range notation also supported:

```json
{
  "action": "read_range",
  "spreadsheet_token": "shtcnxxxx",
  "range": "e7bea9!A1:C5"
}
```

**`value_render_option`** (optional):
- `FORMATTED` — returns display string (e.g. `$45.30`, formula result) ← recommended for reading
- `UNFORMATTED` — raw value (number/string)
- `FORMULA` — returns formula source text (e.g. `=SUM(A1:A10)`)

**`date_time_render_option`** (optional):
- `FormattedString` — human-readable date string
- `SerialNumber` — Excel serial number

---

### 3) Write Range (overwrite)

```json
{
  "action": "write_range",
  "spreadsheet_token": "shtcnxxxx",
  "range": "e7bea9!A1:B2",
  "values": [["name", "score"], ["alice", 95]]
}
```

**`value_input_option`** (optional, default `RAW`):
- `RAW` — values stored as-is (default)
- `USER_ENTERED` — Feishu parses strings (minimal effect; see Formula note below)

**Writing formulas:**  
Prefix the value string with `=` — the tool auto-converts it to the required Feishu formula object format:

```json
{
  "action": "write_range",
  "spreadsheet_token": "shtcnxxxx",
  "range": "e7bea9!D1:D3",
  "values": [["=A1+B1"], ["=A2+B2"], ["=SUM(D1:D2)"]]
}
```

No special handling needed — just use `"=..."` strings and formulas execute correctly.

---

### 4) Append Rows

Appends after last non-empty row in the sheet. `sheet_id` is required (no range needed):

```json
{
  "action": "append_rows",
  "spreadsheet_token": "shtcnxxxx",
  "sheet_id": "e7bea9",
  "values": [["bob", 88], ["carol", 91]]
}
```

With explicit anchor range:

```json
{
  "action": "append_rows",
  "spreadsheet_token": "shtcnxxxx",
  "range": "e7bea9!A1:B1",
  "values": [["dave", 77]],
  "insert_data_option": "INSERT_ROWS"
}
```

**`insert_data_option`**: `OVERWRITE` or `INSERT_ROWS` (default).

---

### 5) Set Format

Applies a numeric display format to a range without changing underlying values.

```json
{
  "action": "set_format",
  "spreadsheet_token": "shtcnxxxx",
  "range": "e7bea9!C1:D12",
  "format": "$#,##0.00"
}
```

`number_format` is an accepted alias for `format`.

Common format strings:
| Format | Example Output |
|---|---|
| `$#,##0.00` | $1,234.56 |
| `0.00%` | 12.34% |
| `0.00` | 3.14 |
| `#,##0` | 1,234 |
| `yyyy-MM-dd` | 2024-01-15 |

> **Tip:** Store monetary values as plain numbers, then apply `set_format` — do NOT embed `$` in the cell string.

---

### 6) Set Style

Applies visual style (font, color, etc.) to a range.

```json
{
  "action": "set_style",
  "spreadsheet_token": "shtcnxxxx",
  "range": "e7bea9!A1:A10",
  "style": {
    "bold": true,
    "fontSize": 12,
    "foreColor": "#FF0000",
    "backColor": "#FFFBE6"
  }
}
```

Supported style keys:
| Key | Type | Description |
|---|---|---|
| `bold` | boolean | Bold text |
| `italic` | boolean | Italic text |
| `underline` | boolean | Underline |
| `fontSize` | number | Font size (pt) |
| `foreColor` | string | Text color (`#RRGGBB`) |
| `backColor` | string | Background fill color (`#RRGGBB`) |

Raw Feishu style fields are also passed through if you need advanced control.

---

### 7) Insert Image (floating)

Inserts a floating image anchored to a cell. The image floats above the grid.

```json
{
  "action": "insert_image",
  "spreadsheet_token": "shtcnxxxx",
  "sheet_id": "e7bea9",
  "cell": "G1",
  "image_path": "/Users/claire/.openclaw/media/browser/screenshot.png",
  "width": 400,
  "height": 300,
  "offset_x": 0,
  "offset_y": 0
}
```

Parameters:
| Param | Required | Description |
|---|---|---|
| `image_path` / `imagePath` | Yes (or `float_image_token`) | Local file path |
| `cell` | Yes | Anchor cell (e.g. `G1`) |
| `sheet_id` | Yes | Sub-sheet ID |
| `width` | No | Image width in px |
| `height` | No | Image height in px |
| `offset_x` | No | X offset from cell top-left (px) |
| `offset_y` | No | Y offset from cell top-left (px) |
| `float_image_token` | No | Use pre-uploaded image token (skip upload) |
| `float_image_id` | No | Custom float image ID |

---

### 8) Insert Cell Image (embedded)

Embeds an image inside a cell (cell-native image, not floating).

```json
{
  "action": "insert_cell_image",
  "spreadsheet_token": "shtcnxxxx",
  "sheet_id": "e7bea9",
  "cell": "L1",
  "image_path": "/Users/claire/.openclaw/media/browser/screenshot.png",
  "image_name": "my_image.png"
}
```

Parameters:
| Param | Required | Description |
|---|---|---|
| `image_path` / `imagePath` | Yes | Local file path |
| `cell` | Yes | Target cell (e.g. `L1`) |
| `sheet_id` | Yes | Sub-sheet ID |
| `image_name` | No | Custom filename (defaults to basename of path) |

> `insert_cell_image` vs `insert_image`: cell images are part of the cell data; float images overlay the grid.

---

## Configuration

```yaml
channels:
  feishu:
    tools:
      sheet: true  # default: true
```

## Required Permissions (Scopes)

| Scope | Required for |
|---|---|
| `sheets:spreadsheet:readonly` | Read-only access |
| `sheets:spreadsheet` | Read + write |
| `wiki:wiki:readonly` | Parsing `/wiki/` URLs |
| `drive:drive` | Image upload (insert_image / insert_cell_image) |

How to grant in Feishu Open Platform:
1. Open your app → **权限管理 / Permissions**
2. Search scope name and enable
3. Publish new app version (test or production)

## Resource Access Reminder

The bot can only operate spreadsheets **shared with the bot account**.

1. Open spreadsheet → Share
2. Add bot as collaborator
3. Grant view/edit permission

## Validation Record

Validated on **2026-02-27** (local machine, `xinge` account):

| Feature | Status |
|---|---|
| `get_meta` | ✅ |
| `write_range` (text/numbers) | ✅ |
| `write_range` (formulas with `=`) | ✅ |
| `read_range` with `FORMATTED` | ✅ |
| `append_rows` | ✅ |
| `set_format` (`$#,##0.00`) | ✅ |
| `set_style` (bold, fontSize) | ✅ |
| `insert_image` (float) | ✅ |
| `insert_cell_image` (embedded) | ✅ |
