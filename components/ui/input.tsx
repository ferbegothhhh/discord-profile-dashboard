import * as React from "react";
import { cn } from "../../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-11 w-full min-w-0 rounded-md border border-input bg-secondary px-3 py-2.5 text-base text-foreground transition-colors selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-foreground aria-invalid:border-destructive motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
