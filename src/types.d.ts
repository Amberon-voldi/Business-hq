// Wrangler bundles *.html as text (see "rules" in wrangler.jsonc).
declare module "*.html" {
  const content: string;
  export default content;
}

// The hq CLI (src/cli/hq.py) is served as text from /agent/hq.
declare module "*.py" {
  const content: string;
  export default content;
}
