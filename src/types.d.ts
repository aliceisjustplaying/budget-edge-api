export interface Env {
  API_KEY:          string;
  SA_EMAIL:         string;
  SA_PRIVATE_KEY:   string;
  SHEET_ID:         string;
  PURPOSE_TAB:      string;  // from vars
  ACCOUNT_TAB:      string;
  TX_RANGE:         string;
  LIST_CACHE:       KVNamespace;
}
