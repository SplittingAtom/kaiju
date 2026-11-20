// The address ranges both proxies refuse live in one place (@kobe/address-policy, KOBE-58 review L6).
export {
  AddressPolicy,
  DEFAULT_DENIED_CIDRS,
  validateCidrs,
  validateInternalTargets,
  type AddressChecker,
  type AddressPolicyOptions,
  type AddressVerdict,
} from "@kobe/address-policy";
