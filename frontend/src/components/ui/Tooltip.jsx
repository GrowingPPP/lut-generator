import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import './Tooltip.css'

export function TooltipProvider({ children, delayDuration = 500, skipDelayDuration = 150, ...props }) {
  return <TooltipPrimitive.Provider {...props} delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>{children}</TooltipPrimitive.Provider>
}

export default function Tooltip({ children, content, side = 'bottom' }) {
  if (!content) return children
  return <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className="ui-tooltip" data-chroma-tooltip-content="true"
        side={side} sideOffset={6} collisionPadding={8}>
        {content}
        <TooltipPrimitive.Arrow className="ui-tooltip-arrow" width={10} height={5} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
}
