import NanaichiDomain

/// ワークフローの想定内の失敗。画面が扱いを決める拒否の種類（`ApiErrorCode`）に1か所で対応づける
/// （TS の `workflows/rejection-code.ts`、ADR 0019）。どちらの記録先でも同じコードになる
public protocol WorkflowError: Error {
    var rejectionCode: ApiErrorCode { get }
}

extension StartSessionError: WorkflowError {
    public var rejectionCode: ApiErrorCode {
        switch self {
        case .sessionAlreadyInProgress: .sessionAlreadyInProgress
        case .eventIdConflict: .eventIdConflict
        }
    }
}

extension OperateSessionError: WorkflowError {
    public var rejectionCode: ApiErrorCode {
        switch self {
        case .noSessionInProgress: .noSessionInProgress
        case .operationRejected: .operationRejected
        case .eventIdConflict: .eventIdConflict
        }
    }
}

extension WriteJournalEntryError: WorkflowError {
    public var rejectionCode: ApiErrorCode {
        switch self {
        case .invalidInput: .invalidRequest
        case .noSessionInProgress: .noSessionInProgress
        case .tagLimitExceeded: .tagLimitExceeded
        case .journalEntryNotFound: .journalEntryNotFound
        }
    }
}

extension EditJournalEntryError: WorkflowError {
    public var rejectionCode: ApiErrorCode {
        switch self {
        case .invalidInput: .invalidRequest
        case .tagLimitExceeded: .tagLimitExceeded
        case .journalEntryNotFound: .journalEntryNotFound
        }
    }
}

extension DeleteJournalEntryError: WorkflowError {
    public var rejectionCode: ApiErrorCode {
        switch self {
        case .journalEntryNotFound: .journalEntryNotFound
        }
    }
}

extension DeleteTagRejected: WorkflowError {
    public var rejectionCode: ApiErrorCode {
        switch self {
        case .tagNotFound: .tagNotFound
        case .reassignToSameTag: .invalidRequest
        }
    }
}

/// 想定内の失敗がないワークフロー（読むだけのものなど）
extension Never: WorkflowError {
    public var rejectionCode: ApiErrorCode { switch self {} }
}
