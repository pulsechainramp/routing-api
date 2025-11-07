import { sanitizeExternalUrl } from "./url";

describe("sanitizeExternalUrl (server)", () => {
  it("allows https links", () => {
    expect(
      sanitizeExternalUrl("https://example.com/path?x=1", { allowHttp: false })
    ).toBe("https://example.com/path?x=1");
  });

  it("normalizes protocol casing", () => {
    expect(
      sanitizeExternalUrl("HTTPS://Example.com/foo", { allowHttp: false })
    ).toBe("https://example.com/foo");
  });

  it("rejects javascript protocol", () => {
    expect(
      sanitizeExternalUrl("javascript:alert(1)", { allowHttp: true })
    ).toBeNull();
  });

  it("rejects http when allowHttp is false", () => {
    expect(sanitizeExternalUrl("http://example.com", { allowHttp: false })).toBe(
      null
    );
  });

  it("allows http when allowHttp is true", () => {
    expect(sanitizeExternalUrl("http://example.com", { allowHttp: true })).toBe(
      "http://example.com/"
    );
  });

  it("rejects links without http(s) scheme", () => {
    expect(sanitizeExternalUrl("//example.com", { allowHttp: true })).toBeNull();
    expect(sanitizeExternalUrl("/relative", { allowHttp: true })).toBeNull();
  });
});
