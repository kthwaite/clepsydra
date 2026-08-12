declare module "single-file-core/single-file.js" {
	export interface PageData {
		content: string;
		title: string;
		filename: string;
		mimeType: string;
	}

	export function getPageData(
		options?: Record<string, unknown>,
		initOptions?: Record<string, unknown>,
		doc?: Document,
		win?: Window,
	): Promise<PageData>;
}
