import fastify from "fastify";
import providersRoutes from "./providers";

describe("/onramps/providers", () => {
  const originalMoonpaySecret = process.env.MOONPAY_SECRET_KEY;
  const originalRampKey = process.env.RAMP_HOST_API_KEY;
  const originalTransakKey = process.env.TRANSAK_KEY;

  afterEach(() => {
    process.env.MOONPAY_SECRET_KEY = originalMoonpaySecret;
    process.env.RAMP_HOST_API_KEY = originalRampKey;
    process.env.TRANSAK_KEY = originalTransakKey;
  });

  it("does not expose signatures or API keys in provider responses", async () => {
    process.env.MOONPAY_SECRET_KEY = "super-secret";
    process.env.RAMP_HOST_API_KEY = "ramp-secret";
    process.env.TRANSAK_KEY = "transak-secret";

    const app = fastify({ logger: false });
    await providersRoutes(app);

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
});
