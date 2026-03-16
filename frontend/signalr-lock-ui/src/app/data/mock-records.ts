export interface MockRecord {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'inactive' | 'pending';
  customer: string;
  amount: number;
}

export const MOCK_RECORDS: MockRecord[] = [
  { id: 'INV-001', title: 'Invoice #001', description: 'Q1 consulting services', status: 'active', customer: 'Acme Corp', amount: 15000 },
  { id: 'INV-002', title: 'Invoice #002', description: 'Software license renewal', status: 'pending', customer: 'Globex Inc', amount: 8500 },
  { id: 'INV-003', title: 'Invoice #003', description: 'Annual maintenance contract', status: 'active', customer: 'Initech LLC', amount: 22000 },
  { id: 'INV-004', title: 'Invoice #004', description: 'Cloud infrastructure setup', status: 'inactive', customer: 'Umbrella Corp', amount: 45000 },
  { id: 'INV-005', title: 'Invoice #005', description: 'Security audit report', status: 'active', customer: 'Wayne Enterprises', amount: 12000 },
  { id: 'INV-006', title: 'Invoice #006', description: 'UI/UX redesign project', status: 'pending', customer: 'Stark Industries', amount: 35000 },
  { id: 'INV-007', title: 'Invoice #007', description: 'Data migration services', status: 'active', customer: 'Oscorp', amount: 18500 },
  { id: 'INV-008', title: 'Invoice #008', description: 'Employee training program', status: 'inactive', customer: 'LexCorp', amount: 9200 },
  { id: 'CUS-001', title: 'Customer Profile #1', description: 'Enterprise account setup', status: 'active', customer: 'Acme Corp', amount: 0 },
  { id: 'CUS-002', title: 'Customer Profile #2', description: 'SMB onboarding', status: 'pending', customer: 'Globex Inc', amount: 0 },
];
