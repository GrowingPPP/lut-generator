import { useEffect, useRef, useState } from 'react'
import { createLocationStore } from '../lib/appLocation.js'

export default function useAppLocation() {
  const store = useRef(null)
  if (!store.current) store.current = createLocationStore()
  const [route, setRoute] = useState(store.current.get)
  useEffect(() => store.current.subscribe(setRoute), [])
  return { route, navigate: store.current.navigate }
}
