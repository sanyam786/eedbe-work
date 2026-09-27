// The catalog of features a workspace can switch on. Only the WhatsApp document
// assistant exists today; new features are added here and get their own routes/pages.

export interface Feature {
  key: string;
  name: string;
  summary: string;
  status: "available" | "coming_soon";
  industries: "all" | string[];
}

export const FEATURES: Feature[] = [
  {
    key: "whatsapp_docbot",
    name: "WhatsApp Document Assistant",
    summary: "Customers message your WhatsApp number and instantly receive their documents, password-protected. Missing documents are chased and sent automatically when uploaded.",
    status: "available",
    industries: "all",
  },
];

export const featureByKey = (k: string) => FEATURES.find((f) => f.key === k);
