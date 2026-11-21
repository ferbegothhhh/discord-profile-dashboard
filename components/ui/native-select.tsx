import * as React from "react";
import { cn } from "../../lib/utils";

function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative w-full has-[select:disabled]:opacity-50" data-slot="native-select-wrapper">
      <select
        data-slot="native-select"
        className={cn(
          "min-h-11 w-full min-w-0 appearance-auto rounded-md border border-input bg-secondary px-3 py-2.5 text-base text-foreground transition-colors selection:bg-primary selection:text-primary-foreground disabled:pointer-events-none disabled:cursor-not-allowed focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-foreground aria-invalid:border-destructive motion-reduce:transition-none",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return <option data-slot="native-select-option" className={cn("bg-[Canvas] text-[CanvasText]", className)} {...props} />;
}

export { NativeSelect, NativeSelectOption };
