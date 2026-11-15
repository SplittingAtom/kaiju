import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "portable-break-glass",
  label: "Portable memory access",
  description:
    "Request and approve time-boxed, read-only, audited access to one person's portable memories.",
  group: "Governance",
  order: 21,
  minRole: "admin",
  status: READY,
});
