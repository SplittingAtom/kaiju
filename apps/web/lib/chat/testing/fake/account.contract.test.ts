import {
  listNotificationsResponseSchema,
  listSchedulesResponseSchema,
  markNotificationsReadResponseSchema,
  projectCheckoutsResponseSchema,
  uiPreferencesResponseSchema,
} from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { FakeKaiju } from "../fake-kaiju";
import { call, expectContract } from "./contract";

describe("fake account area: answers parse with the protocol (KOBE-717)", () => {
  it("preferences, notifications, schedules and checkouts", async () => {
    const fake = new FakeKaiju();
    fake.preferences = { threads_share: 0.3 };
    await expectContract(fake, uiPreferencesResponseSchema, "GET", "/v1/me/preferences");
    await expectContract(fake, uiPreferencesResponseSchema, "PUT", "/v1/me/preferences", {
      threads_share: 0.4,
    });
    await expectContract(fake, listNotificationsResponseSchema, "GET", "/v1/notifications");
    await expectContract(
      fake,
      markNotificationsReadResponseSchema,
      "POST",
      "/v1/notifications/read",
    );
    await expectContract(fake, listSchedulesResponseSchema, "GET", "/v1/schedules");
    await expectContract(fake, projectCheckoutsResponseSchema, "GET", "/v1/me/checkouts");
  });

  it("fails on a deliberate drift", async () => {
    const fake = new FakeKaiju();
    const { body } = await call(fake, "GET", "/v1/notifications");
    const { unread_count: _count, ...drifted } = body as Record<string, unknown>;
    expect(listNotificationsResponseSchema.safeParse({ ...drifted, unreadCount: 0 }).success).toBe(
      false,
    );
  });
});
