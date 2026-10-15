import { bootstrapOnPrem } from "./hosts/bootstrap";

// Import main only after the signed-in CRM context has supplied the API facade.
// main.tsx statically imports services that capture window.dataverseAPI.
void bootstrapOnPrem(() => import("./main"));
