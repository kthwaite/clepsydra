/**
 * `@mixmark-io/domino` ships `lib/index.d.ts`, but that file only declares the
 * *legacy* package name (`declare module 'domino'`). Importing it under its
 * real name therefore resolves to a file with no top-level exports, and TS
 * reports "is not a module".
 *
 * tsconfig `paths` redirects the import here instead.
 */
declare const domino: {
	createDocument(html?: string, force?: boolean): Document;
	createWindow(html?: string, address?: string): Window;
	createDOMImplementation(): DOMImplementation;
};

export default domino;
