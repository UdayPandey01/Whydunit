/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Static export: the site is a read-only view of a committed snapshot, so it
  // needs no server. Drops straight onto Vercel, Netlify or GitHub Pages.
  output: "export",
  images: { unoptimized: true },
};
