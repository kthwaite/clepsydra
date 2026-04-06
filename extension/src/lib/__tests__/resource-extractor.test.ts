import { describe, it, expect } from "vitest";
import { extractDataUris } from "../resource-extractor";

describe("extractDataUris", () => {
	it("extracts data URIs from HTML string", () => {
		const html = `
      <img src="data:image/png;base64,iVBOR" />
      <img src="data:image/jpeg;base64,/9j/4" />
      <link href="data:text/css;base64,Ym9keQ" />
    `;
		const resources = extractDataUris(html);
		expect(resources).toHaveLength(3);
		expect(resources[0].content_type).toBe("image/png");
		expect(resources[0].raw_base64).toBe("iVBOR");
		expect(resources[1].content_type).toBe("image/jpeg");
	});

	it("returns empty array for HTML with no data URIs", () => {
		const html = `<img src="https://example.com/image.png" />`;
		expect(extractDataUris(html)).toHaveLength(0);
	});

	it("deduplicates identical data URIs", () => {
		const html = `
      <img src="data:image/png;base64,AAAA" />
      <img src="data:image/png;base64,AAAA" />
    `;
		const resources = extractDataUris(html);
		expect(resources).toHaveLength(1);
	});
});
