import { basename, relative } from 'node:path'

// Emit the actual feature entry URL so a retry never guesses a dependency URL
// from a browser error message. The ordinary dynamic import still owns preload.
export function lazyModuleUrls() {
  const prefix = '\0chroma-lazy-url:'
  let config
  return {
    name: 'chroma-lazy-module-urls',
    enforce: 'pre',
    configResolved(value) { config = value },
    async resolveId(source, importer) {
      if (!source.endsWith('?lazy-url')) return null
      const resolved = await this.resolve(source.slice(0, -9), importer, { skipSelf: true })
      if (!resolved || resolved.external) throw new Error(`Cannot resolve lazy feature ${source}`)
      return prefix + resolved.id
    },
    load(id) {
      if (!id.startsWith(prefix)) return null
      const source = id.slice(prefix.length)
      if (config.command === 'serve') {
        return `export default ${JSON.stringify(config.base + relative(config.root, source).replaceAll('\\', '/'))}`
      }
      const reference = this.emitFile({ type: 'chunk', id: source, name: basename(source, '.jsx') })
      return `export default import.meta.ROLLUP_FILE_URL_${reference}`
    },
  }
}
