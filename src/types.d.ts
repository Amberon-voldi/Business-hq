// Wrangler bundles *.html as text (see "rules" in wrangler.jsonc).
declare module "*.html" {
  const content: string;
  export default content;
}
