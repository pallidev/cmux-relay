declare module 'qrcode-terminal' {
  interface QRCodeOptions {
    small?: boolean;
  }
  function generate(input: string, options: QRCodeOptions, cb: (qr: string) => void): void;
  function generate(input: string, cb: (qr: string) => void): void;
  export { generate };
  export default { generate };
}
