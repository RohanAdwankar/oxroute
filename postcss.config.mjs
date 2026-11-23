import {fileURLToPath} from "node:url";

const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    [fileURLToPath(new URL("./scripts/text-scale-postcss.cjs",import.meta.url))]: {},
  },
};

export default config;
