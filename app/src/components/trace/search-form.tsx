// 個体の検索フォーム。送信すると /trace?q=… に移る（JavaScript なしでも動く）
export function SearchForm({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <form action="/trace" method="get" role="search" className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-sm text-stone-600">
        管理番号・注文番号・シリアル
        <input
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder="ZB-2609-0118"
          autoComplete="off"
          className="h-11 w-72 max-w-full rounded-md border border-stone-300 bg-white px-3 font-mono text-base text-stone-900"
        />
      </label>
      <button
        type="submit"
        className="h-11 rounded-md bg-blue-700 px-5 text-sm font-medium text-white hover:bg-blue-800"
      >
        検索
      </button>
    </form>
  );
}
