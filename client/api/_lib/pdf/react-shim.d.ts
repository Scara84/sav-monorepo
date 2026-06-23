// Story 4.5 — shim types React minimal pour `_lib/pdf/*`.
//
// `@types/react` n'est pas installé (projet Vue — pas de bundle React côté
// frontend). React est pris en peer dep de `@react-pdf/renderer` à runtime,
// mais sans types. Ce shim déclare le minimum nécessaire pour typer notre
// composant `CreditNotePdf.ts` (createElement + ReactElement) sans ajouter
// `@types/react` à `package.json` (évite ~500 Ko de types inutiles côté
// Vue et une asymétrie Vue-JSX / React-JSX dans le projet).
//
// Si Epic 7+ introduit d'autres composants React server-side, migrer vers
// `@types/react` officiel et supprimer ce shim.

declare module 'react' {
  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly ReactNode[]

  export interface ReactElement<P = unknown, T = unknown> {
    type: T
    props: P
    key: string | number | null
  }

  export function createElement<P = Record<string, unknown>>(
    type: unknown,
    props?: P | null,
    ...children: ReactNode[]
  ): ReactElement<P>

  export interface FC<P = Record<string, unknown>> {
    (props: P): ReactElement | null
  }

  const React: {
    createElement: typeof createElement
  }
  export default React
}

// Namespace global pour les références `React.ReactElement` non-importées.
declare namespace React {
  export type ReactElement<P = unknown, T = unknown> = import('react').ReactElement<P, T>
  export type ReactNode = import('react').ReactNode
  export type FC<P = Record<string, unknown>> = import('react').FC<P>
}
