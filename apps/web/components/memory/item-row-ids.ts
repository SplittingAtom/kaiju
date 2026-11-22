import { itemAnchor } from "./item-checks";

/** Ids of a row's controls, so focus can return to them after the lists change. */
export const editButtonId = (id: string) => `${itemAnchor(id)}-edit`;
export const pinButtonId = (id: string) => `${itemAnchor(id)}-pin`;
export const policyButtonId = (id: string) => `${itemAnchor(id)}-policy`;
