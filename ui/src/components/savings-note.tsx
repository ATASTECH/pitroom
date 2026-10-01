/** What "saved" means, wherever it is shown: an estimate, not an invoice. */
export function SavingsNote({ price }: { price?: string }) {
  return (
    <>
      An estimate, not money back. It is what your main model ({price ?? 'Claude Sonnet'} list prices) would have charged to read the tokens the workers read, minus what the workers cost and the cost of reading their reports.
    </>
  );
}
