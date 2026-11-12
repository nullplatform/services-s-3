// The SDK ships TypeScript sources that import its protobuf definition as a module.
declare module "*.proto" {
  const path: string;
  export default path;
}
