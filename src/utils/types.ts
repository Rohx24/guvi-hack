export type LlmExtraction = {
  employee_codes: string[];
  case_ids: string[];
  phone_numbers: string[];
  upi_ids: string[];
  bank_account_digits: string[];
};

export type AnalystOutput = {
  extracted: LlmExtraction;
  scamScore: number;
  triggers: string[];
};

export type StrategistInput = {
  scamScore: number;
  extracted: LlmExtraction;
  burned: Set<string>;
};

export type StrategistOutput = {
  goal: string;
  reason: string;
};
