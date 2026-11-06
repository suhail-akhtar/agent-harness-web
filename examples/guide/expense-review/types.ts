export type Status = 'pending' | 'approved' | 'rejected';

export interface Expense {
  id: string;
  who: string;
  category: string;
  amount: number;
  note: string;
  status: Status;
  /** Why it was decided so. */
  reason?: string;
  createdAt: string;
}

export interface Data { expenses: Expense[] }
