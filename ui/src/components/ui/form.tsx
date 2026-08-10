import { Text, type TextProps } from "react-aria-components";

export function Description(props: TextProps) {
  return <Text slot="description" className="field-description" {...props} />;
}
