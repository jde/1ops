/** @type {import('next').NextConfig} */
const nextConfig = {
  // Playbook discovery + seed reading happens in Server Components at request
  // time, so nothing is bundled or cached into the deployed artifact.
  reactStrictMode: true,
};

export default nextConfig;
