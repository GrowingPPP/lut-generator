import { Children, cloneElement, createContext, forwardRef, isValidElement, useContext, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import './Tabs.css'

const TabsValue = createContext('')
const classes = (base, extra) => [base, extra].filter(Boolean).join(' ')

export const TabsRoot = forwardRef(function TabsRoot({
  value, defaultValue = '', onValueChange, className, children, ...props
}, ref) {
  const [localValue, setLocalValue] = useState(defaultValue)
  const current = value === undefined ? localValue : value
  const change = next => {
    if (value === undefined) setLocalValue(next)
    onValueChange?.(next)
  }
  return <TabsValue.Provider value={current}>
    <Tabs.Root {...props} ref={ref} value={current} onValueChange={change}
      className={classes('ui-tabs', className)}>{children}</Tabs.Root>
  </TabsValue.Provider>
})

export const TabsList = forwardRef(function TabsList({ className, ...props }, ref) {
  return <Tabs.List {...props} ref={ref} className={classes('ui-tabs-list', className)} />
})

export const TabsTrigger = forwardRef(function TabsTrigger({ className, ...props }, ref) {
  return <Tabs.Trigger {...props} ref={ref} className={classes('ui-tabs-trigger', className)} />
})

export const TabsContent = forwardRef(function TabsContent({
  value, forceMount, asChild, className, children, ...props
}, ref) {
  const active = useContext(TabsValue) === value
  const visibility = { hidden: !active, inert: active ? undefined : '', 'aria-hidden': active ? undefined : true }
  const child = asChild ? Children.only(children) : children
  return <Tabs.Content {...props} {...visibility} ref={ref} value={value}
    forceMount={forceMount} asChild={asChild} data-chroma-tab-panel="true"
    className={classes('ui-tabs-content', className)}>
    {asChild && isValidElement(child) ? cloneElement(child, visibility) : child}
  </Tabs.Content>
})
