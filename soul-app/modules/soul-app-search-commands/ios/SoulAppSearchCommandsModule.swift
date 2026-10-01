import ExpoModulesCore
import UIKit

public final class SoulAppSearchCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SoulAppSearchCommands")

    View(SoulAppSearchCommandsView.self) {
      Events("onCommand")
    }
  }
}

public final class SoulAppSearchCommandsView: ExpoView {
  let onCommand = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
  }

  public override var canBecomeFirstResponder: Bool {
    true
  }

  public override var keyCommands: [UIKeyCommand]? {
    [
      makeCommand("k", modifiers: .command, title: "세션 검색"),
      makeCommand("f", modifiers: .command, title: "세션 검색"),
      makeCommand(UIKeyCommand.inputUpArrow, title: "이전 검색 결과"),
      makeCommand(UIKeyCommand.inputDownArrow, title: "다음 검색 결과"),
      makeCommand("\r", title: "검색 결과 열기"),
      makeCommand(UIKeyCommand.inputEscape, title: "검색 닫기"),
    ]
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if let window, !containsFirstResponder(window) {
      becomeFirstResponder()
    }
  }

  @objc
  private func handleCommand(_ command: UIKeyCommand) {
    onCommand([
      "input": normalizedInput(command.input),
      "command": command.modifierFlags.contains(.command),
    ])
  }

  private func normalizedInput(_ input: String?) -> String {
    guard let input else {
      return ""
    }
    switch input {
    case UIKeyCommand.inputUpArrow:
      return "ArrowUp"
    case UIKeyCommand.inputDownArrow:
      return "ArrowDown"
    case "\r":
      return "Enter"
    case UIKeyCommand.inputEscape:
      return "Escape"
    default:
      return input
    }
  }

  private func makeCommand(
    _ input: String,
    modifiers: UIKeyModifierFlags = [],
    title: String
  ) -> UIKeyCommand {
    let command = UIKeyCommand(
      input: input,
      modifierFlags: modifiers,
      action: #selector(handleCommand(_:))
    )
    command.discoverabilityTitle = title
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  private func containsFirstResponder(_ view: UIView) -> Bool {
    if view.isFirstResponder {
      return true
    }
    return view.subviews.contains(where: containsFirstResponder)
  }
}
