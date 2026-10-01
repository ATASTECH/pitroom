import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** A segmented choice, drawn like the page tabs (a sliding pill) so every switch in the UI looks the same. */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)}>
      <TabsList>
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value}>{o.label}</TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
