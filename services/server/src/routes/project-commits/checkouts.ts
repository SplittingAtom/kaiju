import { Hono } from "hono";
import { type TeamVariables } from "../../authz/middleware.js";
import {
  checkout,
  checkoutWithDiff,
  discard,
  findCheckout,
  projectCheckouts,
  update,
} from "../../projects/checkouts.js";
import { fail, noStorage, type CommitKit } from "./shared.js";

/** The caller's checkout of a project: take, read, discard, update; and everyone's (owners). */
export function projectCheckoutRoutes(kit: CommitKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, sync, owner, withProject } = kit;

  app.post("/:id/checkout", async (c) => {
    if (!sync) return noStorage(c);
    const res = await withProject(
      c,
      "edit",
      async (tx, access) => {
        const done = await checkout(tx, sync, owner(c), access.project);
        if (!done.ok) return fail(c, 409, "archived", "The project is archived.");
        return c.json(done.checkout, 200);
      },
      true,
    );
    return res;
  });

  app.get("/:id/checkout", (c) =>
    withProject(c, "view", async (tx, access) => {
      const found = await checkoutWithDiff(tx, owner(c), access.project.id);
      return found
        ? c.json(found)
        : fail(c, 404, "not_found", "You have no checkout of this project.");
    }),
  );

  app.delete("/:id/checkout", (c) =>
    // Anyone who still sees the project may end their own checkout (also after losing edit).
    withProject(
      c,
      "view",
      async (tx, access) => {
        const ended = await discard(tx, deps.projectMounts, owner(c), access.project.id);
        return ended
          ? c.body(null, 204)
          : fail(c, 404, "not_found", "You have no checkout of this project.");
      },
      true,
    ),
  );

  app.post("/:id/checkout/update", async (c) => {
    if (!sync) return noStorage(c);
    return withProject(
      c,
      "edit",
      async (tx, access) => {
        const row = await findCheckout(
          tx,
          access.project.teamId,
          access.project.id,
          owner(c).userId,
        );
        if (!row) return fail(c, 409, "checkout_required", "Check the project out first.");
        return c.json(await update(tx, sync, owner(c), access.project, row));
      },
      true,
    );
  });

  app.get("/:id/checkouts", (c) =>
    withProject(c, "manage", async (tx, access) =>
      c.json({ checkouts: await projectCheckouts(tx, access.project.teamId, access.project.id) }),
    ),
  );

  return app;
}
