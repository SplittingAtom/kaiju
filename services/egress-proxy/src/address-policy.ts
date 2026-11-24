// The address ranges both proxies refuse live in one place (@kaiju/address-policy, KOBE-58 review L6).
export {
  ALWAYS_DENIED_CIDRS,
  AddressPolicy,
  DEFAULT_DENIED_CIDRS,
  validateCidrs,
  validateInternalTargets,
  type AddressChecker,
  type AddressCheckOptions,
  type AddressPolicyOptions,
  type AddressVerdict,
} from "@kaiju/address-policy";
