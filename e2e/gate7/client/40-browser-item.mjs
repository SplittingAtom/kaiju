/** The owner's pinned memory the u54 browser check opens from a chat (printed: its id and text). */
async function browserItem() {
  const owner = await asOwner(TEAM_A);
  const text = `Gate7 ${N} the parcel room closes at five`;
  const made = await create(owner, { scope: "user", kind: "fact", statement: text, pinned: true });
  out("browser_item", `${made.status}:${made.json.id ?? "-"}`);
  out("browser_item_text", text);
}
