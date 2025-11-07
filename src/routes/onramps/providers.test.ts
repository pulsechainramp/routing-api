import fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const buildApp = async () => {
  const app = fastify({ logger: false });
  const routes = (await import("./providers")).default;
  await routes(app);
  return app;
};

describe("/onramps/providers", () => {
  const originalMoonpaySecret = process.env.MOONPAY_SECRET_KEY;
  const originalRampKey = process.env.RAMP_HOST_API_KEY;
  const originalTransakKey = process.env.TRANSAK_KEY;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.ONRAMPS_JSON_PATH;
  });

  afterEach(() => {
    process.env.MOONPAY_SECRET_KEY = originalMoonpaySecret;
    process.env.RAMP_HOST_API_KEY = originalRampKey;
    process.env.TRANSAK_KEY = originalTransakKey;
  });

  it("does not expose signatures or API keys in provider responses", async () => {
    process.env.MOONPAY_SECRET_KEY = "super-secret";
    process.env.RAMP_HOST_API_KEY = "ramp-secret";
    process.env.TRANSAK_KEY = "transak-secret";

    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/providers?country=US&address=0xdeadbeef&amount=100&fiat=USD",
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      providers: Array<{ id: string; deeplink?: string | null }>;
    };

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("signature=");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("ramp-secret");
    expect(serialized).not.toContain("transak-secret");

    const moonpay = body.providers.find((p) => p.id === "moonpay");
    expect(moonpay).toBeDefined();
    expect(typeof moonpay?.deeplink).toBe("string");
    expect(moonpay?.deeplink ?? "").not.toContain("signature=");

    await app.close();
  });

  it("blocks provider links whose host is not allowlisted", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onramps-hosts-"));
    const tmpJson = path.join(tmpDir, "providers.json");

    const payload = {
      version: "v1",
      generated_at: new Date().toISOString(),
      countries: [
        {
          iso2: "US",
          providers: [
            {
              id: "simplex",
              display_name: "Simplex",
              type: "onramp",
              priority: 1,
              deeplink_template: "https://evil.example/pay",
              coverage_url: "https://evil.example/",
            },
          ],
        },
      ],
      globals: {
        fallback_providers: [],
        deeplink_placeholders: ["{address}", "{amount}", "{fiat}"],
      },
    };

    fs.writeFileSync(tmpJson, JSON.stringify(payload), "utf8");
    process.env.ONRAMPS_JSON_PATH = tmpJson;

    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/providers?country=US",
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      providers: Array<{
        id: string;
        deeplink?: string | null;
        link_blocked?: boolean;
        link_blocked_reason?: string | null;
      }>;
    };

    expect(body.providers).toHaveLength(1);
    const provider = body.providers[0];
    expect(provider.deeplink).toBeNull();
    expect(provider.link_blocked).toBe(true);
    expect(provider.link_blocked_reason).toBe("hostname_mismatch");

    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
