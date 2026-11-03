export type CheckoutAddressProfile =
  | 'blue30'
  | 'home'
  | 'ep_center'
  | 'rep_center';

export type CheckoutAddressFields = {
  email: string;
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  postcode: string;
  phone: string;
  country: string;
  prepId: string;
  company: string;
};

const LABEL_ALIASES: Record<keyof CheckoutAddressFields, string[]> = {
  email: ['email', 'e-mail', 'contactemail'],
  firstName: ['firstname', 'first', 'givenname', 'fname'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  address1: [
    'address',
    'address1',
    'addressline1',
    'street',
    'streetaddress',
    'line1',
  ],
  address2: [
    'address2',
    'addressline2',
    'apartment',
    'suite',
    'line2',
    'apt',
  ],
  city: ['city', 'town'],
  postcode: ['postcode', 'postalcode', 'zip', 'zipcode'],
  phone: ['phone', 'mobile', 'telephone', 'tel'],
  country: ['country', 'countryregion'],
  prepId: ['prepid', 'prep', 'clientid', 'reference', 'ref', 'blue30id'],
  company: ['company', 'organisation', 'organization'],
};

function normalizeLabel(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function matchField(label: string): keyof CheckoutAddressFields | null {
  for (const [field, aliases] of Object.entries(LABEL_ALIASES) as [
    keyof CheckoutAddressFields,
    string[],
  ][]) {
    if (aliases.includes(label)) return field;
  }
  return null;
}

function cleanValue(raw: unknown): string {
  return String(raw ?? '').trim();
}

function isHeaderRow(row: unknown[]): boolean {
  const cells = (row ?? []).map((c) => normalizeLabel(c)).filter(Boolean);
  if (cells.length < 3) return false;
  let hits = 0;
  for (const cell of cells) {
    if (matchField(cell)) hits += 1;
  }
  return hits >= 3;
}

/** Parse COPY SHEET layout: label/value rows or header + data row. */
export function parseCheckoutAddressFromSheet(
  values: unknown[][],
): { address: Partial<CheckoutAddressFields>; errors: string[] } {
  const errors: string[] = [];
  const address: Partial<CheckoutAddressFields> = {};

  if (!values?.length) {
    return { address, errors: ['empty sheet tab'] };
  }

  const headerLayout =
    isHeaderRow(values[0] ?? []) &&
    values.length >= 2 &&
    !isHeaderRow(values[1] ?? []);

  if (headerLayout) {
    const header = (values[0] ?? []).map((h) => normalizeLabel(h));
    const data = values[1] ?? [];
    for (let i = 0; i < header.length; i++) {
      const field = matchField(header[i] ?? '');
      if (!field) continue;
      const value = cleanValue(data[i]);
      if (value) address[field] = value;
    }
  } else {
    for (const row of values) {
      if (!row?.length || row.length < 2) continue;
      const label = normalizeLabel(row[0]);
      if (!label) continue;
      const field = matchField(label);
      if (!field) continue;
      const value = cleanValue(row[1] ?? row[2]);
      if (value) address[field] = value;
    }
  }

  const required: (keyof CheckoutAddressFields)[] = [
    'email',
    'firstName',
    'lastName',
    'address1',
    'city',
    'postcode',
  ];
  for (const key of required) {
    if (!address[key]?.trim()) {
      errors.push(`missing ${key}`);
    }
  }

  if (!address.country?.trim()) {
    address.country = 'United Kingdom';
  }

  return { address, errors };
}
