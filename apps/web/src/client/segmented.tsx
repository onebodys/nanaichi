import { cn } from "@/client/lib/utils";

/** 選択肢を横に並べた切り替え（ラジオボタン）。見た目はモックのセグメント */
export const Segmented = <T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  disabled = false,
}: Readonly<{
  name: string;
  legend: string;
  options: ReadonlyArray<Readonly<{ value: T; label: string }>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}>) => (
  <fieldset
    disabled={disabled}
    className="flex flex-wrap gap-0.5 rounded-[10px] bg-muted p-[3px] disabled:opacity-50"
  >
    <legend className="sr-only">{legend}</legend>
    {options.map((option) => (
      <label
        key={option.value}
        className={cn(
          "flex h-[34px] cursor-pointer items-center rounded-lg px-3.5 text-[13px] text-muted-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
          option.value === value && "bg-card font-semibold text-foreground shadow-xs",
        )}
      >
        <input
          type="radio"
          name={name}
          className="sr-only"
          checked={option.value === value}
          onChange={() => onChange(option.value)}
        />
        {option.label}
      </label>
    ))}
  </fieldset>
);
