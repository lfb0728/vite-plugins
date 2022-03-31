import path from 'path'
import type { Plugin, ResolvedConfig } from 'vite'
import { simple } from 'acorn-walk'
import fastGlob from 'fast-glob'
import {
  hasDynamicImport,
  cleanUrl,
  JS_EXTENSIONS,
  KNOWN_SFC_EXTENSIONS,
  normallyImporteeRegex,
  viteIgnoreRegex,
  importeeRawRegex,
} from './utils'
// import { sortPlugin } from './sort-plugin'
import type { AcornNode, DynamicImportOptions } from './types'
import { AliasContext, AliasReplaced } from './alias'
import { DynamicImportVars, fixGlob } from './dynamic-import-vars'
import { DynamicImportRuntime, generateDynamicImportRuntime } from './dynamic-import-helper'

const PLUGIN_NAME = 'vite-plugin-dynamic-import'

export default function dynamicImport(options: DynamicImportOptions = {}): Plugin {
  let config: ResolvedConfig
  let aliasCtx: AliasContext
  let dynamicImport: DynamicImportVars

  return {
    name: PLUGIN_NAME,
    enforce: 'post',
    config(_config) {
      // sortPlugin(PLUGIN_NAME, _config)
    },
    configResolved(_config) {
      config = _config
      aliasCtx = new AliasContext(_config)
      dynamicImport = new DynamicImportVars(aliasCtx)
    },
    async transform(code, id, opts) {
      const pureId = cleanUrl(id)
      const extensions = JS_EXTENSIONS.concat(KNOWN_SFC_EXTENSIONS)
      const globExtensions = config.resolve?.extensions || extensions
      const { ext } = path.parse(pureId)

      if (/node_modules/.test(pureId)) return
      if (!extensions.includes(ext)) return
      if (!hasDynamicImport(code)) return
      if (await options.filter?.(code, id, opts) === false) return

      const ast = this.parse(code)
      let dynamicImportIndex = 0
      const dynamicImportRecords: {
        node: AcornNode
        importeeRaw: string
        importRuntime?: DynamicImportRuntime
        normally?: GlobNormally['normally']
      }[] = []

      simple(ast, {
        ImportExpression(node: AcornNode) {
          const importeeRaw = code.slice(node.source.start, node.source.end)

          // check @vite-ignore which suppresses dynamic import warning
          if (viteIgnoreRegex.test(importeeRaw)) return

          const matched = importeeRaw.match(importeeRawRegex)
          // currently, only importee in string format is supported
          if (!matched) return

          const [, startQuotation, importee, endQuotation] = matched
          // this is a normal path
          if (normallyImporteeRegex.test(importee)) return

          const replaced = aliasCtx.replaceImportee(importee, id)
          // this is a normal path
          if (replaced && normallyImporteeRegex.test(replaced.replacedImportee)) return

          const globResult = globFiles(
            dynamicImport,
            node,
            code,
            pureId,
            globExtensions,
          )
          if (!globResult) return

          const dyRecord = {
            node: {
              type: node.type,
              start: node.start,
              end: node.end,
            },
            importeeRaw,
          }

          if (Object.keys(globResult).includes('normally')) {
            // this is a normal path
            const { normally } = globResult as GlobNormally
            dynamicImportRecords.push({ ...dyRecord, normally })
          } else {
            const { files, startsWithAliasFiles } = globResult as GlobHasFiles
            if (!files || !files.length) return

            const allImportee = listAllImportee(
              globExtensions,
              files,
              startsWithAliasFiles,
            )
            const importRuntime = generateDynamicImportRuntime(allImportee, dynamicImportIndex++)
            dynamicImportRecords.push({ ...dyRecord, importRuntime })
          }
        },
      })

      let dyImptRutimeBody = ''
      if (dynamicImportRecords.length) {
        for (let len = dynamicImportRecords.length, i = len - 1; i >= 0; i--) {
          const {
            node,
            importeeRaw,
            importRuntime,
            normally,
          } = dynamicImportRecords[i]

          let placeholder: string
          if (normally) {
            placeholder = `import("${normally.glob}")`
          } else {
            placeholder = `${importRuntime.name}(${importeeRaw})`
            dyImptRutimeBody += importRuntime.body
          }

          code = code.slice(0, node.start) + placeholder + code.slice(node.end)
        }

        // TODO: sourcemap

        return code + `
// --------- ${PLUGIN_NAME} ---------
${dyImptRutimeBody}
`
      }

      return null
    },
  }
}

type GlobHasFiles = {
  glob: string
  alias?: AliasReplaced
  files: string[]
  startsWithAliasFiles?: string[]
}
type GlobNormally = {
  normally: {
    glob: string
    alias?: AliasReplaced
  }
}
type GlobFilesResult = GlobHasFiles | GlobNormally | null

function globFiles(
  dynamicImport: DynamicImportVars,
  ImportExpressionNode: AcornNode,
  sourceString: string,
  pureId: string,
  extensions: string[],
): GlobFilesResult {
  const node = ImportExpressionNode
  const code = sourceString

  const { alias, glob: globObj } = dynamicImport.dynamicImportToGlob(
    node.source,
    code.substring(node.start, node.end),
    pureId,
  )
  if (!globObj.valid) {
    if (normallyImporteeRegex.test(globObj.glob)) {
      return { normally: { glob: globObj.glob, alias } }
    }
    // this was not a variable dynamic import
    return null
  }
  let { glob } = globObj
  let globWithIndex: string

  glob = fixGlob(glob) || glob

  // if not extension is not specified, fill necessary extensions
  // e.g. `../views/*` -> `../views/*{.js,.ts,.vue ...}`
  if (!extensions.includes(path.extname(glob))) {
    globWithIndex = glob + '/index' + `{${extensions.join(',')}}`
    glob = glob + `{${extensions.join(',')}}`
  }

  const files = fastGlob.sync(
    globWithIndex ? [glob, globWithIndex] : glob,
    { cwd: /* 🚧 */path.dirname(pureId) },
  )

  let startsWithAliasFiles: string[]

  if (alias) {
    const static1 = alias.importee.slice(0, alias.importee.indexOf('*'))
    const static2 = alias.replacedImportee.slice(0, alias.replacedImportee.indexOf('*'))
    startsWithAliasFiles = files.map(file => file.replace(static2, static1))
  }

  return {
    glob,
    alias,
    files,
    startsWithAliasFiles,
  }
}

function listAllImportee(
  extensions: string[],
  importeeList: string[],
  importeeWithAliasList?: string[],
) {
  return (importeeWithAliasList || importeeList).reduce((memo, importee, idx) => {
    const ext = extensions.find(ext => importee.endsWith(ext))
    const list = [
      importee,
      importee.replace(ext, ''),
    ]
    if (importee.endsWith('index' + ext)) {
      list.push(importee.replace('/index' + ext, ''))
    }

    return Object.assign(memo, { [importeeList[idx]]: list })
  }, {} as Record<string, string[]>)
}
