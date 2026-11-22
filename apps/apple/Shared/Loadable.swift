import NanaichiDomain

/// 読み込んだものの様子。読み込み直している間は、前に読み込んだものを出し続ける
enum Loadable<Value> {
    case loading
    case loadFailed
    case loaded(Value)

    var value: Value? {
        switch self {
        case .loaded(let value): value
        case .loading, .loadFailed: nil
        }
    }

    /// 読み込み直した結果。読めなかったときは、読み込めていたものを残す
    func replacing(with result: Result<Value, BackendError>) -> Loadable<Value> {
        switch (result, self) {
        case (.success(let value), _): .loaded(value)
        case (.failure, .loaded): self
        case (.failure, .loading), (.failure, .loadFailed): .loadFailed
        }
    }
}
