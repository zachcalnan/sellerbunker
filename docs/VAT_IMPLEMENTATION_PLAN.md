# VAT Implementation Plan

## User VAT types (org-level settings)

| Type | Description | Costs input | Profit display | VAT adjustment |
|------|-------------|-------------|----------------|----------------|
| **Non VAT registered** | No VAT reference | Gross costs only | Gross revenue − gross costs | None |
| **VAT standard** | Standard VAT registered | One value per cost (Unit £, Prep £, etc.) with toggle: **costs incl VAT** or **costs excl VAT**; user enters VAT % for calculations | Profit (ex VAT) | VAT Balance = Output VAT − Input VAT, shown per unit/item |
| **VAT flat rate** | Flat rate scheme | Gross costs only | — | VAT adjustment on **sales only** using org’s flat rate % |

- **VAT effective date**: When the user switches type (or first sets VAT), we store a date; the app applies VAT logic only from that date so historical data stays consistent.

---

## Data model (schema)

### Organization (settings)

- `vatRegistrationType`: `NON_VAT_REGISTERED` | `VAT_STANDARD` | `VAT_FLAT_RATE`
- `vatEffectiveDate`: when to start applying VAT logic (nullable)
- `vatFlatRatePct`: flat rate % (for flat rate only)
- `vatRatePct`: standard VAT % used for cost/revenue calculations (for standard)
- `vatCostsIncludeVat`: true = user enters costs incl VAT (standard only)

### OrderItem (VAT breakdown)

All nullable for backfill; store both inc and excl so we can support any user type and switching.

- **Revenue (actual)**: `salePriceIncVat`, `salePriceExVat`, `saleVatAmount`
- **Revenue (estimated)**: `estimatedSalePriceIncVat`, `estimatedSalePriceExVat`, `estimatedSaleVatAmount`
- **Unit cost**: `unitCostIncVat`, `unitCostExVat`, `unitVatAmount`
- **Delivery**: `deliveryIncVat`, `deliveryExVat`, `deliveryVatAmount`
- **Prep**: `prepIncVat`, `prepExVat`, `prepVatAmount`

### Purchase (COGS)

- `costsEnteredInclVat`: true = user entered costs incl VAT; false = excl VAT (only one stored per cost type, other derived).
- `vatRatePct`: VAT % used for deriving ex/incl.
- Existing: `unitCostIncVat`, `deliveryCostIncVat`, `prepCostIncVat`, `totalCostIncVat`.
- New: `unitCostExVat`, `deliveryCostExVat`, `prepCostExVat`, `totalCostExVat` (nullable).

---

## VAT logic (formulas)

- **Net cost** = cost incl VAT ÷ (1 + VAT rate)  
- **VAT (cost)** = cost incl VAT − Net cost  
- **Net revenue** = revenue incl VAT ÷ (1 + VAT rate)  
- **VAT (revenue)** = revenue incl VAT − Net revenue  

**Output VAT** = VAT you charge on sales.  
**Input VAT** = VAT you pay on purchasing stock.  

**Net VAT liability (VAT Balance)** = Output VAT − Input VAT.

- **Non VAT reg**: profit = revenue (incl VAT) − costs (incl VAT); no VAT adjustment.
- **VAT standard**: show **profit (ex VAT)**; separately show **VAT Balance** (output − input) per item/unit.
- **VAT flat rate**: gross costs only; VAT adjustment applied to **sales only** using flat rate %.

---

## UI (by user type)

### VAT standard (COGS modal)

- One input per cost (Unit £, Prep £, etc.) with **toggle**: “Costs incl VAT” / “Costs excl VAT” (user enters one).
- User inputs **VAT %** used for calculations.
- When cost is **incl VAT**: show “VAT paid” and “Total paid” (same as cost incl VAT).
- Show **Profit (ex VAT)** for the unit.
- Below that: **VAT Balance** (Output VAT − Input VAT) for that unit.

### VAT flat rate

- Only **gross costs** (no VAT toggle).
- VAT adjustment applied to sales only using org’s flat rate %.

### Non VAT registered

- **Costs only** (no reference to VAT).

---

## Switching settings

- User can change VAT type / effective date in **Settings** (e.g. top right).
- **VAT effective date** determines from when the app uses net-of-VAT figures and VAT balance; before that date we can keep showing historical (e.g. gross) figures or apply the new logic from that date depending on product decision.

---

## Implementation phases

1. **Schema** ✅ Org VAT fields, OrderItem VAT breakdown, Purchase ex-VAT + `costsEnteredInclVat`.
2. **Backend** VAT helpers (inc/excl conversion, VAT balance); GET/PATCH org VAT settings API.
3. **COGS / Purchase** Accept incl/excl toggle + VAT %; compute and store both inc and ex; show VAT paid and total in modal for standard VAT.
4. **OrderItem** Populate sale/cost VAT fields from revenue and COGS (and estimates); use in profit and VAT balance calculations; respect `vatEffectiveDate`.
5. **UI** Settings VAT section (type, flat rate %, effective date, standard rate %, costs incl toggle); COGS modal toggle and VAT Balance display; dashboard/orders profit and VAT balance by type.
