import { fillTemplate } from "./onrampLinks";

describe("fillTemplate", () => {
  it("returns null when template is missing", () => {
    expect(fillTemplate(null, { address: "0xabc" })).toBeNull();
    expect(fillTemplate(undefined, { address: "0xabc" })).toBeNull();
  });

  it("replaces placeholders with URL-encoded values", () => {
    const template = "https://example.com/?wallet={address}&amount={amount}&fiat={fiat}";
    const result = fillTemplate(template, {
      address: "0xabc123",
      amount: "100.50",
      fiat: "USD",
    });

    expect(result).toBe(
      "https://example.com/?wallet=0xabc123&amount=100.50&fiat=USD"
    );
  });

  it("supports empty optional parameters", () => {
    const template = "https://example.com/?wallet={address}&fiat={fiat}";
    const result = fillTemplate(template, {
      address: undefined,
      fiat: undefined,
    });

    expect(result).toBe("https://example.com/?wallet=&fiat=");
  });
});
