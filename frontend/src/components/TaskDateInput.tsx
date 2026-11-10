import { DatePicker } from "antd";
import dayjs from "dayjs";

// 表单使用用户时区的本地时间字符串；保存时由 Luxon 转换为时间点。
export default function TaskDateInput({
  value,
  onChange,
  dateOnly = false,
  id,
}: {
  value?: string;
  onChange?: (value: string) => void;
  dateOnly?: boolean;
  id?: string;
}) {
  return (
    <DatePicker
      id={id}
      value={value ? dayjs(value) : null}
      showTime={dateOnly ? false : { format: "HH:mm" }}
      format={dateOnly ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm"}
      placeholder={dateOnly ? "选择日期" : "选择日期和时间"}
      onChange={(date) =>
        onChange?.(
          date ? date.format(dateOnly ? "YYYY-MM-DD" : "YYYY-MM-DDTHH:mm") : "",
        )
      }
      style={{ width: "100%" }}
      allowClear
    />
  );
}
