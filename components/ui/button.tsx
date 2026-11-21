import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-md border text-sm font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:border-dashed disabled:text-muted-foreground aria-invalid:border-destructive motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default: "border-ring bg-primary text-primary-foreground enabled:hover:bg-primary-hover enabled:active:bg-primary-active disabled:border-input disabled:bg-secondary",
        outline: "border-input bg-secondary text-foreground enabled:hover:bg-secondary-hover enabled:active:bg-secondary-active",
      },
      size: {
        default: "px-4 py-2.5",
        swatch: "h-auto w-full flex-col items-stretch justify-start gap-0 whitespace-normal rounded-lg p-0 text-left",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({ className, variant = "default", size = "default", asChild = false, type = "button", ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" data-variant={variant} data-size={size} type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
