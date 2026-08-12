import { Text, type TextProps } from "react-aria-components";
import { type FormProps, Form as RACForm } from "react-aria-components/Form";

export function Form(props: FormProps) {
  return <RACForm {...props} />;
}

export function Description(props: TextProps) {
  return <Text slot="description" className="" {...props} />;
}
