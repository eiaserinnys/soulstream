import type { SettingField } from "../config/SettingFieldWidget";

/** 설정 필드 위젯(SettingFieldWidget)에 넘기는 한 줄 입력 정의. 값은 위젯의 value로 따로 준다. */
export function gitTextField(key: string, label: string, description = ""): SettingField {
  return { key, field_name: key, label, description, value: null, value_type: "str", sensitive: false, hot_reloadable: true, read_only: false };
}
