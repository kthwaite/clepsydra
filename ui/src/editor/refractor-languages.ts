import { refractor } from "refractor";
import jsx from "refractor/jsx";
import tsx from "refractor/tsx";

// The common refractor bundle omits jsx/tsx, but they are curated common
// languages for this (React/TypeScript) project. Register them on the shared
// refractor singleton so TSX/JSX code blocks both highlight and appear in the
// language picker. (tsx's own registration pulls in jsx + typescript, but we
// register jsx explicitly too — registration is idempotent.)
refractor.register(jsx);
refractor.register(tsx);

export { refractor };
