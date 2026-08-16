import request from "supertest";
import { createApp } from "../src/service/app.js";
import { config } from "../src/service/config.js";
import { startFakeBeacon, type FakeBeacon } from "./fakeBeaconInstance.js";

export const app = createApp();
export const agent = request(app);
export const adminHeaders = { "x-admin-key": config.adminKey };

export async function registerFakeInstance(name = "Test Instance"): Promise<{ instance: any; fake: FakeBeacon }> {
  const fake = await startFakeBeacon();
  const res = await agent
    .post("/admin/instances")
    .set(adminHeaders)
    .send({ name, originUrl: fake.url, bootstrapAdminKey: fake.bootstrapKey });
  if (res.status !== 201) {
    throw new Error(`registerFakeInstance failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { instance: res.body, fake };
}
