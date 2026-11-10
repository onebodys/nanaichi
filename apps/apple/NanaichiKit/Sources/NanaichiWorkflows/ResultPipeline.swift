/// byethrow の `Result.andThen` などに相当する、ワークフローを上から下へつなぐための関数。
///
/// 記録先の読み書きは想定外の障害で例外を投げうるので、標準の `flatMap` と違い変換に `throws` を許す。
/// 想定内の失敗は `Result` の失敗として流し、例外はそのまま呼び出し側（記録先）へ投げる
extension Result {
    /// 成功なら次のステップへ進む
    func andThen<NewSuccess>(_ transform: (Success) throws -> Result<NewSuccess, Failure>) rethrows
        -> Result<NewSuccess, Failure>
    {
        switch self {
        case .success(let value): try transform(value)
        case .failure(let error): .failure(error)
        }
    }

    /// 成功なら値を変える
    func tryMap<NewSuccess>(_ transform: (Success) throws -> NewSuccess) rethrows -> Result<NewSuccess, Failure> {
        try andThen { .success(try transform($0)) }
    }

    /// 成功なら記録などの副作用を行い、値はそのまま流す
    func andThrough(_ effect: (Success) throws -> Void) rethrows -> Result<Success, Failure> {
        try tryMap { value in
            try effect(value)
            return value
        }
    }
}
